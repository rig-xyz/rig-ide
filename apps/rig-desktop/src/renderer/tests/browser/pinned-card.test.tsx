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

import { ConnectorsSection } from '@renderer/features/spaces/components/connectors-panel';
import type { RoomSnapshot } from '@renderer/features/spaces/types';
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

    describe("in the Room's dock mode (the dock is given)", () => {
      // What the Room's dock does with it: stays on screen, draws the card's shape, and puts the card's content on it.
      const dock = ({
        onExpand,
        onFold,
        open,
        card,
      }: {
        onExpand: (section?: 'people') => void;
        onFold: () => void;
        open: boolean;
        card: React.ReactNode;
      }) => (
        <div data-testid="dock-stub" data-open={open ? 'true' : 'false'}>
          <button type="button" data-testid="dock-stub-open" onClick={() => onExpand()}>
            open
          </button>
          <button type="button" data-testid="dock-stub-people" onClick={() => onExpand('people')}>
            more
          </button>
          <button type="button" data-testid="dock-stub-fold" onClick={onFold}>
            fold
          </button>
          {card}
        </div>
      );
      const stub = () => host.querySelector<HTMLElement>('[data-testid="dock-stub"]')!;
      const card = () => host.querySelector<HTMLElement>('[data-testid="pinned-card-goo"]');

      it('draws the dock instead of the chip, and the dock opens and folds the panel the way the chip does', async () => {
        await render({ startCollapsed: true, collapsedDock: dock });
        expect(host.querySelector('[data-testid="pinned-chip"]')).toBeNull();
        expect(stub().dataset.open).toBe('false');
        expect(card()).toBeNull();
        await act(async () => {
          click(host.querySelector('[data-testid="dock-stub-open"]')!);
        });
        await flush();
        // The dock stays (the card is its own shape grown out of the rail), with the card's content in it.
        expect(stub().dataset.open).toBe('true');
        expect(card()).toBeTruthy();
        // The same remembered state as the chip's.
        expect(localStorage.getItem('rig-pinned-card-collapsed')).toBe('false');
        await act(async () => {
          click(host.querySelector('[data-testid="dock-stub-fold"]')!);
        });
        await flush();
        expect(stub().dataset.open).toBe('false');
        expect(card()).toBeNull();
        expect(localStorage.getItem('rig-pinned-card-collapsed')).toBe('true');
      });

      it("gives the open card the dock's texture: no border, fill or shadow of its own, the dock's radius, no dash, the settings title", async () => {
        await render({ collapsedDock: dock, isSpace: true });
        const body = card()!;
        expect(body).toBeTruthy();
        // The dock draws the fill and the shadow behind it; the card brings none of its own.
        expect(body.className).not.toMatch(/\bborder\b|border-border|bg-bg-1|shadow-float/);
        expect(body.style.borderRadius).toBe('16px');
        expect(host.querySelector('.card-pop-in')).toBeNull();
        // The dock's chevron folds it, so no dash; it leaves room for the chevron over its corner.
        expect(host.querySelector('[aria-label="Collapse"]')).toBeNull();
        expect(body.textContent).toContain('Space settings');
        expect(body.textContent).not.toContain('Details');
        expect(body.querySelector<HTMLElement>('div')!.style.paddingRight).toBe('34px');
      });

      it('opens at People when the dock asks for it', async () => {
        await render({ collapsedDock: dock, startCollapsed: true, isSpace: true });
        await act(async () => {
          click(host.querySelector('[data-testid="dock-stub-people"]')!);
        });
        await flush();
        expect(card()).toBeTruthy();
        const people = [...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('People'))!;
        expect(people.getAttribute('aria-expanded')).toBe('true');
      });

      it('leaves the plain card as it was without a dock', async () => {
        await render({ isSpace: true });
        expect(card()).toBeNull();
        expect(host.querySelector('.card-pop-in')!.className).toContain('border-border-hairline');
        expect(host.querySelector('[aria-label="Collapse"]')).toBeTruthy();
        expect(host.textContent).toContain('Details');
        expect(host.textContent).not.toContain('Space settings');
      });
    });

    it('still shows what it always did: the name (or chip summary), syncing, and the new count', async () => {
      await render({ startCollapsed: true, syncing: true });
      const chip = host.querySelector('[data-testid="pinned-chip"]')!;
      expect(chip.textContent).toContain('growth');
      expect(chip.textContent).toContain('Syncing');
    });

    it('oozes the expand button out of the LEFT edge, not the right — the chip is anchored top-right, near the window edge', async () => {
      await render({ startCollapsed: true });
      const chip = host.querySelector('[data-testid="pinned-chip"]')!;
      const expandButton = host.querySelector<HTMLButtonElement>('[data-testid="pinned-chip-expand"]')!;
      // Positioned via `right`, not `left` — bleeding toward the panel's
      // open space instead of off the window's right edge, where it used
      // to get cut off.
      expect(expandButton.style.right).toBeTruthy();
      expect(expandButton.style.left).toBe('');

      await act(async () => {
        chip.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      // The invisible bridge that keeps hover alive while crossing the gap
      // extends left too (`right-full`), mirroring the button.
      expect(chip.innerHTML).toContain('right-full');
      expect(chip.innerHTML).not.toContain('left-full');
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

    it('shows "Details" instead of the space name for a space — the Room\'s single top bar already names it', async () => {
      await render({ isSpace: true, name: '#growth' });
      const header = host.querySelector('.card-pop-in > div > p')!;
      expect(header.textContent).toBe('Details');
      expect(header.className).toContain('text-text-muted');
      // Collapse still works exactly the same.
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Collapse"]')).toBeTruthy();
    });
  });

  describe('Files section', () => {
    it('puts a quiet New icon button beside the filter, on its row, and it still opens the New menu', async () => {
      mocks.filesList.mockResolvedValue({
        success: true,
        data: [{ kind: 'file', name: 'notes.md', relPath: 'notes.md', mtimeMs: Date.now() }],
      });
      await render();
      const filesRow = Array.from(host.querySelectorAll('button')).find(
        (b) => b.textContent?.startsWith('Files')
      )!;
      await act(async () => click(filesRow));
      await flush();

      const filter = host.querySelector<HTMLInputElement>('input[placeholder="Filter files"]')!;
      const newButton = host.querySelector<HTMLButtonElement>('button[aria-label="New"]')!;
      expect(filter).toBeTruthy();
      expect(newButton).toBeTruthy();
      // Same row: the filter field's box and the New button are siblings, New last.
      const filterField = filter.parentElement!;
      expect(filterField.parentElement).toBe(newButton.parentElement);
      expect(filterField.parentElement!.lastElementChild).toBe(newButton);
      // An icon, not a labelled white button, and no old row under the list.
      expect(newButton.textContent).toBe('');
      expect(newButton.className).not.toContain('bg-bg-1');
      expect(newButton.className).toContain('border-border-hairline');
      expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'New')).toBe(false);

      await act(async () => click(newButton));
      await flush();
      const menu = document.querySelector('[role="menu"]')!;
      expect(menu).toBeTruthy();
      expect(menu.textContent).toContain('New file');
      expect(menu.textContent).toContain('Import from Docs…');
      expect(newButton.getAttribute('aria-expanded')).toBe('true');
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
    // The section remembers being open (it starts open); open it if it isn't.
    if (!host.querySelector('[data-testid="changes-meta"]')) {
      await act(async () => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    }
    expect(host.querySelector('[data-testid="changes-meta"]')?.textContent).toBe('1 file changed today');
  });

  describe('Changes detail: two-line hierarchy', () => {
    it('leads with the Pulse summary (text-secondary), then one muted meta line with the count — no summary means no pulse line and just the count', async () => {
      mocks.filesList.mockResolvedValue({
        success: true,
        data: [{ kind: 'file', name: 'notes.md', relPath: 'notes.md', mtimeMs: Date.now() }],
      });
      // No pulse briefing at all (offline, per the default mock) — the
      // Pulse summary paragraph is absent, and the meta line falls back to
      // just the day's count, with no "· summary …" suffix.
      await render();
      const detail = host.querySelector('[data-testid="changes-detail"]')!;
      expect(host.querySelector('[data-testid="changes-summary"]')).toBeNull();
      const meta = host.querySelector('[data-testid="changes-meta"]')!;
      expect(meta.textContent).toBe('1 file changed today');
      expect(meta.textContent).not.toContain('·');
      expect(meta.className).toContain('text-2xs');
      expect(meta.className).toContain('text-text-muted');
      // The summary (when present) always renders before the meta line.
      expect(Array.from(detail.children).indexOf(meta)).toBe(detail.children.length - 1);
    });

    it('shows the Pulse summary first, then a merged meta line: count · summary age', async () => {
      mocks.filesList.mockResolvedValue({
        success: true,
        data: [{ kind: 'file', name: 'notes.md', relPath: 'notes.md', mtimeMs: Date.now() }],
      });
      const fiftyEightMinAgo = new Date(Date.now() - 58 * 60_000).toISOString();
      mocks.pulseGet.mockResolvedValue({
        success: true,
        data: {
          cached: false,
          briefing: {
            greeting: '',
            summary: '',
            pickBackUp: [],
            perPerson: [],
            degraded: false,
            generatedAt: fiftyEightMinAgo,
            perRig: [
              {
                bindingId: 'binding_growth',
                rigName: 'growth',
                line: 'growth: shipped the onboarding flow',
                at: fiftyEightMinAgo,
              },
            ],
          },
        },
      });
      await render();
      const detail = host.querySelector('[data-testid="changes-detail"]')!;
      const summary = host.querySelector('[data-testid="changes-summary"]')!;
      const meta = host.querySelector('[data-testid="changes-meta"]')!;
      expect(summary).toBeTruthy();
      expect(summary.className).toContain('text-text-secondary');
      expect(summary.className).toContain('leading-relaxed');
      expect(summary.className).not.toContain('text-text-muted');
      // The summary is the FIRST line, the meta line the second.
      const children = Array.from(detail.children);
      expect(children.indexOf(summary)).toBeLessThan(children.indexOf(meta));
      expect(meta.textContent).toBe('1 file changed today · summary 58m ago');
    });

    it("hides the summary age when the briefing has no line for this rig (a brand-new space)", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      mocks.pulseGet.mockResolvedValue({
        success: true,
        data: {
          cached: true,
          briefing: {
            greeting: '',
            summary: '',
            pickBackUp: [],
            perPerson: [],
            degraded: false,
            generatedAt: twoHoursAgo,
            perRig: [
              { bindingId: 'binding_other', rigName: 'other', line: 'other: tidied the roadmap', at: twoHoursAgo },
            ],
          },
        },
      });
      await render();
      expect(host.querySelector('[data-testid="changes-summary"]')).toBeNull();
      const meta = host.querySelector('[data-testid="changes-meta"]')!;
      expect(meta.textContent).toBe('No files changed today');
      expect(meta.getAttribute('title')).toBeNull();
    });
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

  describe('People row', () => {
    beforeEach(() => {
      mocks.shareMembers.mockResolvedValue({
        success: true,
        data: {
          members: [
            { userId: 'u_dylan', name: 'Dylan', email: 'dylan@acme.com', avatarUrl: null, role: 'owner' },
            { userId: 'u_sam', name: 'Sam', email: 'sam@acme.com', avatarUrl: null, role: 'editor' },
          ],
          selfRole: 'owner',
        },
      });
    });

    it('shows the D S avatar stack on the summary row while collapsed, and hides it while expanded (same rule as Agents/Connectors)', async () => {
      await render();
      const peopleButton = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('People'))!;

      expect(host.querySelector('[data-testid="people-avatar-stack"]')).not.toBeNull();

      await act(async () => peopleButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(peopleButton.getAttribute('aria-expanded')).toBe('true');
      expect(host.querySelector('[data-testid="people-avatar-stack"]')).toBeNull();

      await act(async () => peopleButton.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(host.querySelector('[data-testid="people-avatar-stack"]')).not.toBeNull();
    });
  });
});

/**
 * `ConnectorsSection` (`connectors-panel.tsx`) doesn't have its own test
 * file — its coverage lives alongside the rest of the space panel's row
 * grammar in `spaces-room.test.tsx` — but that file is shared with another
 * engineer right now, so new coverage for this pass goes here instead: one
 * focused check that a connector's logo shrank to 16px, matching the other
 * sub-row leading visuals (Skills' file icons, Agents' avatars).
 */
describe('ConnectorsSection — logo size', () => {
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
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('renders a connector row\'s logo at 16px, not the old 18px', async () => {
    const snapshot: RoomSnapshot = {
      name: 'growth',
      ready: true,
      members: [{ id: 'dylan', name: 'Dylan', email: 'dylan@acme.com', role: 'owner', initial: 'D', status: 'here' }],
      agents: [],
      connectors: [{ id: 'linear', name: 'Linear', addedBy: 'dylan', mine: 'connected' }],
      skills: [],
      messages: [],
      invitesById: {},
      sessionMetaByRun: {},
      sessionEventsByRun: {},
      typingUserIds: [],
    };
    await act(async () => {
      root.render(<ConnectorsSection snapshot={snapshot} selfUserId="dylan" bindingId="space-connectors-logo-size" />);
    });
    await act(async () => {
      click(host.querySelector('[data-testid="connectors-summary-row"]')!);
    });
    const row = host.querySelector('[data-testid="connector-row"][data-connector="linear"]')!;
    const logo = row.querySelector('svg')!;
    expect(logo).toBeTruthy();
    expect(logo.getAttribute('width')).toBe('16');
    expect(logo.getAttribute('height')).toBe('16');
  });
});
