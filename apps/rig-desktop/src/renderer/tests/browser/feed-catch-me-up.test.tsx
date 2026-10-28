import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The empty Feed after Not now: Rig has never read for them, so it offers
 * Catch me up, which starts the catch-up; once Rig has read, it's the plain
 * empty line.
 */

const orch = vi.hoisted(() => ({
  since: vi.fn(),
  catchUpNow: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { rig: { orch } }, events: { on: () => () => {} } }));

import { FeedEmpty } from '@renderer/features/home-feed/catch-me-up';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  orch.since.mockReset();
  orch.catchUpNow.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <FeedEmpty live />
      </QueryClientProvider>
    )
  );
};
const q = (sel: string) => host.querySelector<HTMLElement>(sel);

describe('the empty Feed', () => {
  it('offers Catch me up to someone Rig never read for, and starts it', async () => {
    orch.since.mockResolvedValue({ success: true, data: { since: null } });
    orch.catchUpNow.mockResolvedValue({ success: true, data: { outcome: 'started' } });
    await mount();
    await vi.waitFor(() => expect(q('[data-testid="feed-catch-me-up"]')).not.toBeNull());
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Catch me up'))!;
    await act(async () => button.click());
    expect(orch.catchUpNow).toHaveBeenCalledTimes(1);
    // The catch-up strip shows it reading; the offer steps aside.
    await vi.waitFor(() => expect(q('[data-testid="feed-catch-me-up"]')).toBeNull());
  });

  it('comes back when the catch-up could not start', async () => {
    orch.since.mockResolvedValue({ success: true, data: { since: null } });
    orch.catchUpNow.mockResolvedValue({ success: true, data: { outcome: 'skipped' } });
    await mount();
    await vi.waitFor(() => expect(q('[data-testid="feed-catch-me-up"]')).not.toBeNull());
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Catch me up'))!;
    await act(async () => button.click());
    await vi.waitFor(() => expect(q('[data-testid="feed-catch-me-up"]')).not.toBeNull());
  });

  it('is the plain line once Rig has read for them', async () => {
    orch.since.mockResolvedValue({ success: true, data: { since: '2026-10-27T09:00:00.000Z' } });
    await mount();
    await vi.waitFor(() => expect(host.textContent).toContain('Nothing waiting on you.'));
    expect(q('[data-testid="feed-catch-me-up"]')).toBeNull();
  });
});
