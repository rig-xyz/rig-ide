import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeRigRow } from '@renderer/features/home/home-sections';
import type { RigSpaceStatus } from '@shared/rig/space-status';

/**
 * Polish round 2, lane F (Dylan: "Home is never blank") — a space with
 * nothing live right now used to be dropped from "Across your spaces"
 * entirely; it now gets its own compact one-line row below the active
 * cards, so the section (and Home overall) is never empty just because
 * nobody's agent happens to be running this second.
 */

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    rig: {
      pulse: { get: async () => ({ success: false, error: { kind: 'relay', message: 'offline' } }) },
      spacesConnection: {
        listConnectors: async () => ({ success: true, data: [] }),
        listMembers: async () => ({ success: true, data: [] }),
      },
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

import { AcrossYourSpaces } from '@renderer/features/home/across-your-spaces';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function localSpaceRow(bindingId: string, name: string): HomeRigRow {
  return {
    kind: 'local',
    bindingId,
    isSpace: true,
    name,
    path: `/rigs/${name}`,
    lastOpenedAt: Date.now(),
    sessions: [],
    paused: false,
    outsideHome: false,
    notARigAnymore: false,
    role: 'owner',
  };
}

describe('AcrossYourSpaces', () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('lists a recently-quiet space as a compact one-line row, not dropped, when nothing is active', async () => {
    const quietRow = localSpaceRow('b-quiet', 'ops');
    const statusByBinding = new Map<string, RigSpaceStatus>();

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AcrossYourSpaces spaceRows={[quietRow]} statusByBinding={statusByBinding} onOpenPath={() => {}} />
        </QueryClientProvider>
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('Across your spaces');
    expect(host.textContent).toContain('ops');
    expect(host.textContent).toContain('Quiet');
    // No live-card-only chrome (faces query etc.) for the quiet row.
    expect(host.querySelector('button')).not.toBeNull();
  });

  it('renders nothing at all when there are no spaces', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AcrossYourSpaces spaceRows={[]} statusByBinding={new Map()} onOpenPath={() => {}} />
        </QueryClientProvider>
      );
    });
    expect(host.textContent).toBe('');
  });
});
