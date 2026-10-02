import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Room chrome round coverage for the topbar's own decisions — see each
 * covered prop's doc comment on `Topbar` in `App.tsx`:
 *  - the layout switch (Chat | Split | Doc) shows only once a doc is open
 *    beside a space's Room; a plain rig keeps it on regardless;
 *  - the open doc joins the breadcrumb, with its own close control;
 *  - a space's member faces sit on the left of its accent Invite pill, as
 *    one trigger for one people-and-invite popover.
 * `pinned-card.test.tsx` covers the "Details" panel header; `time-format.
 * test.ts` covers the duration formatter.
 */

const mocks = vi.hoisted(() => ({
  shareMembers: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      auth: { status: async () => ({ signedIn: true }) },
      account: { me: async () => ({ success: false, error: { message: 'signed out' } }), workspaces: async () => ({ success: true, data: [] }) },
      recent: { recentRigs: async () => [] },
      share: {
        members: (...args: unknown[]) => mocks.shareMembers(...args),
        listMyInvites: async () => ({ success: true, data: { invites: [] } }),
        collaborators: async () => ({ success: true, data: [] }),
      },
      pulse: { get: async () => ({ success: false, error: { kind: 'relay', message: 'offline' } }) },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { Topbar } from '@renderer/App';
import type { RigLayout } from '@renderer/features/shell/layout-switcher';
import { RigShareButton } from '@renderer/features/rig-share/rig-share-button';

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('Topbar', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
    mocks.shareMembers.mockReset().mockResolvedValue({ success: true, data: { members: [], selfRole: 'owner' } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const baseProps = {
    variant: 'rig' as const,
    scrolled: false,
    onGoHome: () => {},
    onOpenSettings: () => {},
    onOpenPath: () => {},
    onOpenFolder: () => {},
    updateReady: false,
  };
  const rigContext = { kind: 'rig' as const, name: 'growth', bindingId: 'b1', path: '/rigs/growth' };
  const switcher = (layout: RigLayout) => ({ layout, hiddenTabCount: 0, onChange: () => {} });

  async function render(props: Partial<React.ComponentProps<typeof Topbar>>) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Topbar {...baseProps} context={rigContext} {...props} />
        </QueryClientProvider>
      );
    });
  }

  describe('the layout switch', () => {
    it('stays hidden for a space until a doc is open beside the Room', async () => {
      await render({ isSpace: true, hasOpenDoc: false, layoutSwitcher: switcher('chat') });
      expect(host.querySelector('[role="radiogroup"]')).toBeNull();

      await render({ isSpace: true, hasOpenDoc: true, layoutSwitcher: switcher('split') });
      expect(host.querySelector('[role="radiogroup"]')).not.toBeNull();
    });

    it('stays on for a plain rig regardless of whether a doc is open', async () => {
      await render({ isSpace: false, hasOpenDoc: false, layoutSwitcher: switcher('chat') });
      expect(host.querySelector('[role="radiogroup"]')).not.toBeNull();
    });

    it('renders nothing while no rig is bound', async () => {
      await render({ layoutSwitcher: null });
      expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    });
  });

  describe('the doc breadcrumb', () => {
    it('joins the breadcrumb with the open doc\'s name and a close control', async () => {
      const closed: boolean[] = [];
      await render({
        isSpace: true,
        docBreadcrumb: { name: 'metrics.md', onClose: () => closed.push(true) },
      });
      expect(host.textContent).toContain('metrics.md');
      const closeButton = host.querySelector<HTMLButtonElement>('[aria-label="Close doc"]')!;
      expect(closeButton).toBeTruthy();
      await act(async () => click(closeButton));
      expect(closed).toEqual([true]);
    });

    it('is absent when no doc is open', async () => {
      await render({ isSpace: true, docBreadcrumb: null });
      expect(host.querySelector('[aria-label="Close doc"]')).toBeNull();
    });
  });

  describe('People and Share', () => {
    it('shows a space\'s member faces on the left of its Invite pill, as one trigger (people and invite are one thing)', async () => {
      mocks.shareMembers.mockResolvedValue({
        success: true,
        data: { members: [{ userId: 'u1', name: 'Dylan', email: 'dylan@acme.com', avatarUrl: null, role: 'owner' }], selfRole: 'owner' },
      });
      await render({
        isSpace: true,
        sharePillSlot: <RigShareButton root="/rigs/growth" name="growth" variant="pill" />,
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const trigger = host.querySelector<HTMLButtonElement>('[aria-label="People and invites"]');
      expect(trigger).toBeTruthy();
      expect(trigger!.textContent).toContain('Invite');
      // The faces live inside the same button, before the pill.
      expect(trigger!.textContent!.indexOf('D')).toBeLessThan(trigger!.textContent!.indexOf('Invite'));
      expect(host.querySelector('[aria-label="People"]')).toBeNull();
      expect(host.textContent).not.toContain('Share');
      // One popover (portaled to document.body, like every other `Popover`
      // in this app): who's here, and inviting someone new.
      await act(async () => click(trigger!));
      expect(document.body.textContent).toContain('Dylan');
    });

    it('shows only the combined trigger beside the name for a plain rig, not the split People/Share pair', async () => {
      await render({
        isSpace: false,
        shareSlot: <RigShareButton root="/rigs/growth" name="growth" />,
      });
      expect(host.querySelector('[aria-label="People"]')).toBeNull();
      const shareButtons = [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes('Share'));
      expect(shareButtons).toHaveLength(1);
    });
  });

  describe('the Home variant', () => {
    const homeContext = { kind: 'none' as const };
    const header = () => host.querySelector<HTMLElement>('header')!;
    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

    it('is bare on Home: no fill and no hairline, the bell and the gear float at the top right over a drag region', async () => {
      const opened: boolean[] = [];
      await render({
        context: homeContext,
        variant: 'home',
        onOpenSettings: (focusAbout) => opened.push(Boolean(focusAbout)),
      });
      await settle();
      const bar = header();
      expect(bar.dataset.variant).toBe('home');
      expect(bar.className).not.toMatch(/\bborder-b\b|border-border-hairline|\bbg-bg-1\b/);
      expect(bar.querySelector('hr, [role="separator"]')).toBeNull();
      // The strip is still the window's drag region; its buttons are not.
      expect(bar.className).toContain('[-webkit-app-region:drag]');
      expect(bar.querySelector('[aria-label="Activity"]')).not.toBeNull();
      const gear = bar.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!;
      expect(gear).not.toBeNull();
      expect(gear.parentElement?.className).toContain('[-webkit-app-region:no-drag]');
      await act(async () => click(gear));
      expect(opened).toEqual([false]);
      // No breadcrumb on Home.
      expect(bar.querySelector('[aria-label="Home"]')).toBeNull();
    });

    it('stays without a hairline once Home has scrolled beneath it', async () => {
      await render({ context: homeContext, variant: 'home', scrolled: true });
      expect(header().className).not.toMatch(/\bborder-b\b|border-border-hairline/);
    });

    it('keeps its fill and hairline on every other screen', async () => {
      await render({ variant: 'rig' });
      expect(header().dataset.variant).toBe('rig');
      expect(header().className).toContain('border-b');
      expect(header().className).toContain('bg-bg-1');
    });
  });
});
