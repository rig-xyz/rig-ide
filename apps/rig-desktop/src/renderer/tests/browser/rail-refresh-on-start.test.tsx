import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A session Rig starts shows in the rail at once: on the start, the recent
 * chats are asked for again, and again once its row has been written.
 */

const handlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {},
  events: {
    on: (channel: { name?: string } | string, handler: (payload: unknown) => void) => {
      handlers.set(typeof channel === 'string' ? channel : String(channel.name ?? 'channel'), handler);
      return () => {};
    },
  },
}));

import { RECENT_CHATS_KEY, STARTED_ROW_MS, useRefreshChatsOnStart } from '@renderer/features/home-feed/use-real-spaces';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
});

function Probe() {
  useRefreshChatsOnStart();
  return null;
}

describe('useRefreshChatsOnStart', () => {
  it('asks for the recent chats again on a start, and again once its row is written', async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    await act(async () => root!.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    expect(handlers.size).toBe(1);
    const onStart = [...handlers.values()][0]!;
    act(() => onStart({ sessionId: 's1', bindingId: 'b1' }));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: RECENT_CHATS_KEY });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2), { timeout: STARTED_ROW_MS + 1000 });
  });
});
